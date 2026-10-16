# replay-parity build entry points. Compatible with GNU Make 3.81.

PNPM ?= pnpm
REFERENCE_URL ?= http://127.0.0.1:3001

.PHONY: all install build typecheck lint format test test-unit test-int coverage check-prose check-secrets check-parallel check recording bench-capture demo demo-down clean

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

demo:
	@echo "make demo is implemented in build step 7." && exit 1

demo-down:
	@echo "make demo-down is implemented in build step 7." && exit 1

clean:
	rm -rf packages/*/dist demo/*/dist coverage demo/out
