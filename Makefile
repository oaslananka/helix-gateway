.PHONY: dev build test lint typecheck audit sbom docker-build docker-up docker-down clean

dev:
	npm run dev

build:
	npm run build

test:
	npm test

lint:
	npm run lint

typecheck:
	npx tsc --noEmit

audit:
	npm audit --audit-level=high

sbom:
	npx @cyclonedx/cyclonedx-npm --output-format json --output-file sbom.json
	@echo "SBOM generated: sbom.json"

docker-build:
	docker build -t helix-gateway:latest .

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

clean:
	rm -rf dist node_modules

help:
	@echo "Available targets: dev build test lint typecheck audit sbom docker-build docker-up docker-down clean"
