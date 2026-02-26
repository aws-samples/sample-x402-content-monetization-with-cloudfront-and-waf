EDITOR_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../../editor

build-EditorDeployFunction:
	cd $(EDITOR_DIR) && npm ci && npm run build
	mkdir -p $(ARTIFACTS_DIR)/editor-assets
	cp -r $(EDITOR_DIR)/dist/* $(ARTIFACTS_DIR)/editor-assets/
	cp $(dir $(abspath $(lastword $(MAKEFILE_LIST))))index.js $(ARTIFACTS_DIR)/index.js
