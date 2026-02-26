CONTENT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../../../sample-content

build-SampleContentDeployFunction:
	mkdir -p $(ARTIFACTS_DIR)/content-assets
	cp -r $(CONTENT_DIR)/* $(ARTIFACTS_DIR)/content-assets/
	cp $(dir $(abspath $(lastword $(MAKEFILE_LIST))))index.js $(ARTIFACTS_DIR)/index.js
