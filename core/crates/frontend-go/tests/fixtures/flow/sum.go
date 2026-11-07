package fixture

// Data-flow fixture: line numbers match the feature scenarios.























































func sum(xs []int) {
	acc := 0
	for _, x := range xs {
		acc = acc + x
	}
}
