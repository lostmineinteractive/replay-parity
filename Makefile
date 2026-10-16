# replay-parity build entry points. Compatible with GNU Make 3.81.

PNPM ?= pnpm

.PHONY: all install build typecheck lint format test test-unit test-int coverage check-prose check-secrets check demo demo-down clean

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

check: lint typecheck test check-prose check-secrets

demo:
	@echo "make demo is implemented in build step 7." && exit 1

demo-down:
	@echo "make demo-down is implemented in build step 7." && exit 1

clean:
	rm -rf packages/*/dist demo/*/dist coverage demo/out
