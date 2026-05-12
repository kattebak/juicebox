SHELLCHECK ?= shellcheck

SHELL_FILES := $(shell find . \
	-type f \
	\( -name '*.sh' -o -path './bin/juice-bot' \) \
	-not -path './node_modules/*' \
	-not -path './.git/*' \
	-not -path './.claude/*')

.PHONY: lint
lint:
	@if [ -z "$(SHELL_FILES)" ]; then \
		echo "no shell files found"; exit 1; \
	fi
	$(SHELLCHECK) -x -S style -P SCRIPTDIR $(SHELL_FILES)

.PHONY: list-shell
list-shell:
	@printf '%s\n' $(SHELL_FILES)
