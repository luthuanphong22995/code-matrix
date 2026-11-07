package fixture

// Data-flow fixture: line numbers match the feature scenarios.

























func handle(ready bool) {
	status := 200
	log(status)
	if !ready {
		status = 404
	}

	write(status)



	code := read()
	if ready {
		// the code is ready
		write(code)
	} else {
		// not ready
		log(code)
	}
}
