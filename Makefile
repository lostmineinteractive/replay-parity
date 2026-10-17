# replay-parity build entry points. Compatible with GNU Make 3.81.

PNPM ?= pnpm
REFERENCE_URL ?= http://127.0.0.1:3000
CANDIDATE_URL ?= http://127.0.0.1:3002

.PHONY: all install build typecheck lint format test test-unit test-int coverage check-prose check-secrets check-parallel check recording bench-capture bench-replay demo demo-down screenshots clean

all: install lint build test

install:
	$(PNPM) install --frozen-lockfile

build:
	$(PNPM) build

typecheck:
	$(PNPM) typecheck

lint:
	$(PNPM) lint

format:
	$(PNPM) format

test:
	$(PNPM) test

test-unit:
	$(PNPM) test:unit

test-int:
	$(PNPM) test:int

coverage:
	$(PNPM) test:coverage

check-prose:
	sh scripts/check-prose.sh

check-secrets:
	sh scripts/check-secrets.sh

check-parallel:
	sh scripts/check-parallel.sh

check: lint typecheck test check-prose check-secrets check-parallel

recording:
	$(PNPM) --filter @replay-parity/scripts exec tsx make-recording.ts

bench-capture:
	$(PNPM) --filter @replay-parity/scripts exec tsx bench-capture.ts --reference $(REFERENCE_URL)

bench-replay:
	$(PNPM) --filter @replay-parity/scripts exec tsx bench-replay.ts --candidate $(CANDIDATE_URL)

demo:
	sh scripts/demo.sh

demo-down:
	docker compose -f demo/docker-compose.yml down -v --remove-orphans

screenshots:
	sh scripts/screenshots.sh

clean:
	rm -rf packages/*/dist demo/*/dist coverage demo/out
