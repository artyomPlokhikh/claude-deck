UUID := claude-deck@artyomplokhikh.github.io
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SRC := extension
DIST := dist

.PHONY: all css schemas install uninstall pack lint test screenshots clean

all: css schemas

# Light and dark stylesheets from one template; GNOME Shell picks the variant itself.
# Both names must carry the variant suffix: the shell only swaps stylesheets on a light/dark
# switch when the loaded one is stylesheet-dark.css or stylesheet-light.css.
css: $(SRC)/stylesheet-dark.css $(SRC)/stylesheet-light.css
$(SRC)/stylesheet-dark.css: src/stylesheet.css.in
	sed 's/@FG@/255, 255, 255/g' $< > $@
$(SRC)/stylesheet-light.css: src/stylesheet.css.in
	sed 's/@FG@/0, 0, 0/g' $< > $@

schemas:
	glib-compile-schemas $(SRC)/schemas

# Development install: symlink, so edits are picked up on the next login.
install: all
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR)/$(SRC) $(EXT_DIR)
	@echo "Installed. Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -f $(EXT_DIR)

pack: all
	mkdir -p $(DIST)
	gnome-extensions pack $(SRC) --force --out-dir=$(DIST) \
		--extra-source=lib --extra-source=worker --extra-source=tools --extra-source=icons \
		--extra-source=stylesheet-dark.css --extra-source=stylesheet-light.css --extra-source=../LICENSE --extra-source=../CUSTOMIZING.md
	@ls -l $(DIST)

lint:
	npm install --silent --no-audit --no-fund
	npx eslint extension tests
	sh -n $(SRC)/tools/statusline-tee.sh

test: all
	tests/headless/run.sh

clean:
	rm -rf $(DIST) $(SRC)/schemas/gschemas.compiled

screenshots: test
	gjs -m tests/headless/crop.js tests/headless/out screenshots
