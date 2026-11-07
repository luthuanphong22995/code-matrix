package com.example;

import com.example.config.Config;
import com.example.util.*;
import com.example.util.Mover;
import java.util.List;
import static com.example.config.Config.parseEnv;

public class App {
    public static void main(String[] args) {
        Config config = Config.parse(args[0]);
        parseEnv();
        String data = Files.readFile("data.txt");
        fetchData();
        Server server = new Server();
        List<Config> list = new java.util.ArrayList<>();
        list.add(config);
        Mover.move();
        run(config);
    }

    static void run(Config config) {
    }
}
