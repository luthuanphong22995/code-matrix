package main

import "example.com/app/internal/db"

type Config struct {
	Name string
	Conn *db.Conn
}

type Source interface {
	Load() (Config, error)
}

func parseConfig() Config {
	db.Open()
	parseEnv()
	return Config{Name: "app"}
}

func parseEnv() {}

func (c Config) Validate() {}

type Level int

func (l Level) String() string {
	return "level"
}
