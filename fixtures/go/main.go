package main

import "fmt"

func main() {
	cfg := parseConfig()
	fetchData()
	readFile()
	cfg.Validate()
	var c Config = cfg
	fmt.Println(c)
}
