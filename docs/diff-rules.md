# Diff rules

The rules file tells the differ which differences between a reference response and a candidate response are expected. Rules are data: a YAML file passed with `--rules`, embedded in full in every run under `rules`. `examples/diff-rules.yaml` lists every key with a comment, `examples/rule-packs/` holds two packs to include, and `demo/diff-rules.yaml` and `demo/diff-rules-unordered.yaml` are the files the demo runs with. This page covers every key, how a rule is scoped, the findings each rule produces and how they are explained, rule packs, and the two commands that help write a rules file: `rp rules lint` and `rp rules suggest`.

## How a response pair is compared

The differ compares the status, then the listed headers, then the bodies. Bodies are walked together: objects key by key in sorted order, arrays index by index, or as sets under an `unordered` rule. Every difference is a finding with a `path`, a `kind`, and `tolerated`. A finding is tolerated when a rule covers it, and the finding then names the rule. The verdict of the pair is `match` with no findings, `tolerated` when every finding is tolerated, and `mismatch` otherwise. The same inputs always give byte identical findings.

At one path the rules are consulted in this order: `ignore` first, then `decimal` and `time`, then `unordered` for arrays, then the type check with `numeric_strings`, then `tolerances` for numbers, substitutions, and `mask` for strings. A missing or extra value goes through `null_absent`, `empty_absent`, and `extra_fields`. When two rules of one kind match a path, the first in the file applies.

## Paths

Rule paths use a JSONPath subset:

| Syntax               | Meaning                                                              |
| -------------------- | -------------------------------------------------------------------- |
| `$`                  | the whole body                                                       |
| `.name`, `['name']`  | a member of an object                                                |
| `[n]`                | an array element                                                     |
| `[*]`, `.*`          | any element or member                                                |
| `[?(@.type=='fee')]` | the elements of an array whose child `type` equals the literal       |
| `[?(@.type!='fee')]` | the elements whose child differs from it, or that lack the child     |
| `..name`, `..[*]`    | recursive descent: the segment that follows, at this depth and below |

A filter compares one child, written `@.name` or `@['name']`, with `==` or `!=` against a string in single or double quotes or a number. A string never equals a number, so `[?(@.qty=='1')]` does not admit `{"qty": 1}`. A filter rule matches when the element on either side satisfies it, so a field that a filter admits on one side only is still covered. Filters work inside unordered arrays too, where the finding path holds a keyed segment such as `[sku=A-100]`.

Filters and recursive descent are accepted in rule paths only: `ignore`, `tolerances`, `unordered.path`, `decimal`, `time`, and `mask`. An `unordered` key and a substitution capture take the plain subset. A rule without a filter or a descent is matched against the finding path alone; one with either is matched against the documents being compared.

## Scope

Every rule entry takes an optional `when`:

```yaml
unordered:
  - path: '$.items'
    key: '$.sku'
    when: { tags: [list-inventory], methods: [GET], paths: ['/v1/inventory/**'] }
```

`tags` matches an exchange that carries any of the tags, `methods` one whose method is any of them (case blind), and `paths` one whose request path matches any of the globs, with `*` within a segment, `**` across segments, and `?` for one character. Every list given must match; at least one must be given. A rule without `when` is global and applies to every exchange.

The differ learns the exchange through an optional context, `{ tags, method, path }`, the fourth argument of `diff`. A rule whose `when` does not match the context is skipped. A caller that passes no context gets every rule, scoped or not, so scopes take effect where the caller names the exchange. `rp rules lint` and the preflight evaluate scopes against each recorded exchange.

## Keys

### `include`

A list of rules files merged before this one, resolved relative to this file. See [Rule packs](#rule-packs).

### `ignore`

Paths removed from both sides before comparison. No finding is produced at or below an ignored path, whatever other rule names it. An entry is a path or `{ path, when }`.

```yaml
ignore:
  - '$..request_id'
  - { path: "$.lines[?(@.type=='fee')].note", when: { tags: [create-order] } }
```

### `tolerances`

`{ path, abs, rel, when }`: two numbers are tolerated when they differ by at most `abs`, or by at most `rel` times the larger magnitude. At least one of `abs` and `rel` is required. Rule name `tolerances[i]`; detail `within abs 0.005`, or `outside abs 0.005 of tolerances[0]` when the rule matched and the numbers are too far apart.

### `unordered`

`{ path, key, when }`: the array at `path` is compared as a set. With `key`, rows are paired by the value at that path inside each row and findings carry a keyed segment such as `$.items[sku=A-100].qty`; without it, the array is compared as a multiset and only the surplus elements on each side are reported. Unordered comparison produces no finding of its own, so it has no rule name in findings.

### `decimal`

`{ path, scale, when }`: a decimal string or a number is rounded to `scale` fraction digits, half away from zero, using integer arithmetic on the digits of its text, never through a floating point value. The rounded texts are compared, so `"29.90"`, `"29.9"`, and `29.9` are equal at scale 2, `"1.005"` equals `"1.01"` at scale 2, and `"-1.005"` equals `"-1.01"`. A value that is not a decimal (`1e3`, `"n/a"`, `true`) is compared as usual. Rule name `decimal[i]`; detail `equal after rounding to 2 places`, or `differ after rounding to 2 places under decimal[0]`.

### `time`

`{ path, abs_ms, format, when }`: two timestamps within `abs_ms` milliseconds are tolerated. `format` is `iso8601` (the default: a date, or a date and time with an optional fraction and zone, read as UTC without a zone), `epoch_ms`, or `epoch_s`; the epoch formats read a number or a string that spells one. A value that does not read under the format is compared as usual. Rule name `time[i]`; detail `412 ms apart, within 1000 ms`, or `2000 ms apart, outside 1000 ms of time[0]`.

### `mask`

`{ path, pattern, when }`: two strings that both match the pattern are tolerated. The pattern is anchored at both ends, so `ord_[0-9a-f]{8}` does not match `xord_12345678`. Each pattern is compiled once; a pattern that does not compile is a configuration error when the rules load. Rule name `mask[i]`; detail `both match ord_[0-9a-f]{8}`.

### `extra_fields` and `extra_fields_rules`

`extra_fields: deny` (the default) reports a field the candidate adds as an `unexpected` finding. `allow` tolerates it under the rule name `extra_fields`. Only object members count; an extra array element is always reported, and a missing field is never tolerated by this rule.

`extra_fields_rules: [{ allow, when }]` overrides the setting where its scope matches. The first entry whose scope matches decides, and the finding names it, as in `extra_fields_rules[1]`; where none matches, `extra_fields` decides.

### `equivalences`

```yaml
equivalences:
  null_absent: true # null and an absent field compare equal
  empty_absent: false # "", [], {}, and an absent field compare equal
  numeric_strings: false # "12.5" and 12.5 compare equal
```

A single mapping applies everywhere. A list of mappings scopes them, each with its own `when`; a flag is on when any matching entry turns it on. The finding names the flag, as in `equivalences.null_absent` for the single form and `equivalences[1].numeric_strings` for the list form. `numeric_strings` accepts the plain number grammar only: an optional minus sign, an integer part without leading zeros, and an optional fraction, so `"01"` and `"1e3"` are not numbers.

### `status.equivalent`

A list of classes of equivalent status codes, as `[200, 201]`, or `{ classes, when }` for scoped classes. Rule name `status.equivalent[i]`, or `status.equivalent[i].classes[j]` for the scoped form.

### `headers`

```yaml
headers:
  compare: [content-type, etag] # names compared, case blind; default none
  ignore: [etag] # names taken out of the comparison
  masks:
    - { name: content-type, pattern: 'application/json(; charset=utf-8)?' }
```

`compare` and `ignore` entries are a name or `{ name, when }`. `ignore` removes a name from `compare` wherever its scope matches, which is how a file undoes a pack's entry. A compared header whose two values both match a mask's anchored pattern is tolerated under `headers.masks[i]` with detail `both match <pattern>`. A header absent on one side is never masked.

### `substitutions`

A value captured from every exchange carrying the tag, on the reference and on the candidate. Later requests have the reference value replaced with the candidate value in the listed locations (`apply`, default `[path, query, body]`), and the differ tolerates the pair under `substitution:<name>`. The capture reads:

| Capture                        | Value                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------- |
| `{ tag, path }`                | the string or number at the path in the response body                           |
| `{ tag, header, pattern }`     | the response header, through the first group of the pattern, or the whole match |
| `{ tag, header }`              | the whole response header                                                       |
| `{ tag, from: request, path }` | the string or number at the path in the request body                            |

A request capture reads the recorded request on the reference side and the request as sent on the candidate side, which differ when an earlier substitution or an override rewrote it.

### `controls`

`tags`: harness controls such as a restart. Replayed in order as barriers, diffed on status only, excluded from statistics and thresholds.

## Explanations

`rp report --explain` and the agent loop render each finding as a sentence. A tolerated finding ends with the rule, and for `decimal`, `time`, `mask`, `headers.masks`, `extra_fields`, `extra_fields_rules`, and `equivalences` with the reason:

```text
The value at $.total differs. The reference has "29.90" and the candidate has 29.9. Tolerated by rule decimal[0]: equal after rounding to 2 places.
The candidate is missing $.note. The reference has null. Tolerated by rule equivalences.null_absent: null and absent are equivalent.
Header x-request-id differs. The reference sent "r-1" and the candidate sent "r-2". Tolerated by rule headers.masks[0]: both match r-\d+.
```

## Rule packs

`include` lists other rules files, resolved relative to the including file. The packs are merged before validation: a list in a pack comes before the including file's entries of the same key, mappings such as `headers` merge key by key, and a scalar such as `extra_fields` set in the including file wins over one set in a pack. A pack may include packs of its own. A missing file and an include cycle are configuration errors that name the chain, as in `c.yaml: include cycle a.yaml -> c.yaml -> d.yaml -> c.yaml`.

Rule names count entries after the merge, so `time[0]` in a finding is the first `time` entry of the first pack that has one.

```yaml
include:
  - rule-packs/timestamps.yaml
  - rule-packs/ids.yaml
headers:
  ignore: [x-request-id] # undoes the ids pack's compared header
```

## rp rules lint

```sh
rp rules lint --rules diff-rules.yaml --recording recording.jsonl [--json]
```

Loads the rules with their packs and prints every rule with its kind, its target, its scope, and how many recorded exchanges it reaches out of those in its scope: response bodies with at least one match for a path rule, responses carrying the header for a header rule, and producing exchanges for a substitution. A rule that reaches none is a `warn` line. The last block lists, for each tag in the recording, the rules in effect for at least one exchange carrying it. `--json` prints the same as one object. The command exits 0 with warnings and 1 on a rules file that does not load.

## rp rules suggest

```sh
rp rules suggest --recording first.jsonl --recording second.jsonl --out suggested.yaml [--json]
```

Takes two recordings of the same traffic, such as two captures against the reference, and pairs their exchanges by position and method. Each pair is diffed under empty rules and the differences are grouped by path, with indices widened to `[*]`. For each path whose findings are all value changes:

- `time` when every value reads as ISO 8601, or as epoch milliseconds or seconds in a plausible range, with `abs_ms` the smallest of 1 s, 5 s, 1 min, 5 min, 1 h, and 1 day that covers the largest gap seen;
- `mask` when every value is a string of one shape: a UUID, a shared literal prefix ending in punctuation followed by one character class, or one class at one length;
- `ignore` when the value differs in every pair that holds it, in at least two pairs, with no shape in common.

Every suggestion is preceded by a comment with its evidence counts. Everything else (a value that differs in some pairs only, missing and extra fields, type changes, status and body format differences) is listed as unexplained in comments at the end. The output is a valid rules file for review; nothing is applied to any rules file. A recording compared with itself gives no suggestions.
