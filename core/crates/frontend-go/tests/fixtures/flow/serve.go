package fixture

// Data-flow fixture: line numbers match the feature scenarios.





















































































func serve() {
	limit := 5

	f := func() int {
		n := limit
		return n + limit
	}
	f()
	print(limit)
}
