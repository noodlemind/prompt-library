SHELL := /bin/sh

SOURCE := engineer-cgroup-exec.c
OUTPUT ?= /opt/engineer/bin/engineer-cgroup-exec
PROBE_SOURCE := engineer-task-isolation-probe.c
PROBE_OUTPUT ?= /opt/engineer/bin/engineer-task-isolation-probe
DENIAL_PROBE_SOURCE := engineer-readiness-denial-probe.c
DENIAL_PROBE_OUTPUT ?= /opt/engineer/bin/engineer-readiness-denial-probe
CC ?= cc

ALPINE_CPPFLAGS := -D_GNU_SOURCE=1 -D_FORTIFY_SOURCE=3
ALPINE_CFLAGS := -std=c11 -O2 -fPIE -fstack-protector-strong -fno-ident \
	-ffile-prefix-map=$(CURDIR)=. -fdebug-prefix-map=$(CURDIR)=. \
	-Wall -Wextra -Werror -Wpedantic -Wconversion -Wformat=2 -Wshadow
ALPINE_LDFLAGS := -static-pie -Wl,--build-id=none -Wl,-z,noexecstack -Wl,-z,relro -Wl,-z,now -s

.PHONY: alpine-static task-isolation-probe-static readiness-denial-probe-static
alpine-static:
	@test "$$(uname -s)" = Linux
	@install -d -m 0755 "$$(dirname "$(OUTPUT)")"
	@set -eu; temporary="$(OUTPUT).tmp"; trap 'rm -f "$$temporary"' EXIT HUP INT TERM; \
		LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH="$${SOURCE_DATE_EPOCH:-0}" \
		"$(CC)" $(ALPINE_CPPFLAGS) $(ALPINE_CFLAGS) "$(SOURCE)" $(ALPINE_LDFLAGS) -o "$$temporary"; \
		chmod 0555 "$$temporary"; \
		mv "$$temporary" "$(OUTPUT)"; \
		trap - EXIT HUP INT TERM

task-isolation-probe-static:
	@test "$$(uname -s)" = Linux
	@test "$$(uname -m)" = x86_64
	@install -d -m 0755 "$$(dirname "$(PROBE_OUTPUT)")"
	@set -eu; temporary="$(PROBE_OUTPUT).tmp"; trap 'rm -f "$$temporary"' EXIT HUP INT TERM; \
		LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH="$${SOURCE_DATE_EPOCH:-0}" \
		"$(CC)" $(ALPINE_CPPFLAGS) $(ALPINE_CFLAGS) "$(PROBE_SOURCE)" $(ALPINE_LDFLAGS) -o "$$temporary"; \
		chmod 0555 "$$temporary"; \
		mv "$$temporary" "$(PROBE_OUTPUT)"; \
		trap - EXIT HUP INT TERM

readiness-denial-probe-static:
	@test "$$(uname -s)" = Linux
	@test "$$(uname -m)" = x86_64
	@install -d -m 0755 "$$(dirname "$(DENIAL_PROBE_OUTPUT)")"
	@set -eu; temporary="$$(mktemp "$(DENIAL_PROBE_OUTPUT).tmp.XXXXXX")"; trap 'rm -f "$$temporary"' EXIT HUP INT TERM; \
		LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH="$${SOURCE_DATE_EPOCH:-0}" \
		"$(CC)" $(ALPINE_CPPFLAGS) $(ALPINE_CFLAGS) "$(DENIAL_PROBE_SOURCE)" $(ALPINE_LDFLAGS) -o "$$temporary"; \
		chmod 0555 "$$temporary"; \
		mv "$$temporary" "$(DENIAL_PROBE_OUTPUT)"; \
		trap - EXIT HUP INT TERM
