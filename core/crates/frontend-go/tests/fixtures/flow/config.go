package fixture

// Data-flow fixture: line numbers match the feature scenarios.

var defaultPath = "config.yaml"

func open(path string) []int { return nil }

func read() int { return 0 }

func parseConfig(path string) int {
	total := 0
	for _, n := range open(path) {
		total = total + n
	}
	unused := defaultPath
	if read() > 0 {
		return total
	}
	log(path)
	return 0
}
