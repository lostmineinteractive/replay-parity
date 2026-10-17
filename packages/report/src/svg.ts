import { fmtNumber } from './format.js';

/**
 * Server side SVG histograms. One bar per bin for each series, reference
 * behind the candidate. No script, no external resource, deterministic.
 */
export interface HistogramInput {
  edges: readonly number[];
  reference: readonly number[];
  candidate: readonly number[];
  width?: number | undefined;
  height?: number | undefined;
  title?: string | undefined;
}

export const SVG_REFERENCE_COLOR = '#8fa3b5';
export const SVG_CANDIDATE_COLOR = '#d9534f';

const LABEL_EDGES = [0.1, 1, 10, 100, 1000, 10_000];

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderHistogram(input: HistogramInput): string {
  const width = input.width ?? 640;
  const height = input.height ?? 140;
  const bins = Math.max(input.reference.length, input.candidate.length);
  const padLeft = 8;
  const padBottom = 22;
  const padTop = input.title === undefined ? 6 : 22;
  const plotW = width - padLeft * 2;
  const plotH = height - padBottom - padTop;
  const barW = bins === 0 ? 0 : plotW / bins;
  const max = Math.max(1, ...input.reference, ...input.candidate);
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(input.title ?? 'latency histogram')}">`,
  );
  if (input.title !== undefined) {
    out.push(`<text x="${padLeft}" y="14" font-size="12" fill="#333">${esc(input.title)}</text>`);
  }
  const baseline = padTop + plotH;
  out.push(
    `<line x1="${padLeft}" y1="${baseline}" x2="${padLeft + plotW}" y2="${baseline}" stroke="#999" stroke-width="1"/>`,
  );
  const bar = (series: readonly number[], color: string, cls: string, inset: number): void => {
    for (let i = 0; i < bins; i += 1) {
      const count = series[i] ?? 0;
      const h = (count / max) * plotH;
      const x = padLeft + i * barW + inset;
      const w = Math.max(0, barW - inset * 2);
      out.push(
        `<rect class="${cls}" x="${r(x)}" y="${r(baseline - h)}" width="${r(w)}" height="${r(h)}" fill="${color}" data-count="${count}"/>`,
      );
    }
  };
  bar(input.reference, SVG_REFERENCE_COLOR, 'reference', 0.5);
  bar(input.candidate, SVG_CANDIDATE_COLOR, 'candidate', barW * 0.25);
  for (let i = 0; i < input.edges.length; i += 1) {
    const edge = input.edges[i] as number;
    if (!LABEL_EDGES.some((l) => Math.abs(edge - l) < l * 0.02)) continue;
    const x = padLeft + i * barW;
    out.push(
      `<line x1="${r(x)}" y1="${baseline}" x2="${r(x)}" y2="${baseline + 4}" stroke="#999" stroke-width="1"/>`,
    );
    out.push(
      `<text x="${r(x)}" y="${baseline + 16}" font-size="10" fill="#555" text-anchor="middle">${fmtNumber(edge)} ms</text>`,
    );
  }
  out.push(
    `<text x="${padLeft + plotW}" y="${padTop + 10}" font-size="10" fill="#555" text-anchor="end">max ${max}</text>`,
  );
  out.push('</svg>');
  return out.join('');
}

function r(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
