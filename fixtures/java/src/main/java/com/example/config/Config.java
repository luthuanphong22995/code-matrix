package com.example.config;

public class Config {
    private final String name;

    public Config(String name) {
        this.name = name;
    }

    public static Config parse(String raw) {
        return new Config(raw);
    }

    public static Config parseEnv() {
        return parse(System.getenv("APP_CONFIG"));
    }
}

record Setting(String key, int value) {
}
