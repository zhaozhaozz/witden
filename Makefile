.PHONY: install build dev test test-docker lint images platform

install:
	npm ci

# Compile all packages (shared, runner, manager, server) and the console.
build:
	npm run build

# Everything in one process on embedded PostgreSQL (./data), real Docker computers.
dev: build
	node packages/server/dist/cli.js serve

# Fast tests: simulated computers, embedded PostgreSQL.
test:
	npm test

# Everything, including real Docker, the computer images and the end-to-end test.
test-docker: images
	npm run test:docker

lint:
	npm run lint
	npm run typecheck

# Computer images used by the built-in templates (built from the repository root).
images:
	docker build -f images/shell/Dockerfile -t witden/computer-shell:latest .
	docker build -f images/desktop/Dockerfile -t witden/computer-desktop:latest .

# Platform image (api, worker and manager processes).
platform:
	docker build -t witden/platform:latest .
