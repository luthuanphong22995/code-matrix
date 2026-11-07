// Fixture for jumpToSource.test.ts: parseConfig starts on line 12 (1-based) and ends on line 40.
package config

import (
	"errors"
	"strings"
)

// Config is a parsed key=value file.
type Config map[string]string

func parseConfig(text string) (Config, error) {
	cfg := Config{}
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		// Blank lines and comments carry nothing.
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}

		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, errors.New("line " + itoa(i+1) + ": missing '='")
		}

		key = strings.TrimSpace(key)
		if key == "" {
			return nil, errors.New("line " + itoa(i+1) + ": empty key")
		}
		if _, dup := cfg[key]; dup {
			return nil, errors.New("line " + itoa(i+1) + ": duplicate key " + key)
		}

		cfg[key] = strings.TrimSpace(value)
	}
	return cfg, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for ; n > 0; n /= 10 {
		digits = string(rune('0'+n%10)) + digits
	}
	return digits
}
