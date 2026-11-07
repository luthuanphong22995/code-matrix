package com.example;

import com.example.config.Config;

public class Server extends Base implements Lifecycle {
    private Config config;

    public Server() {
        this.config = Config.parse("default");
    }

    public void start() {
        start(8080);
    }

    public void start(int port) {
        log("starting");
        this.stop();
    }

    public void stop() {
    }
}
