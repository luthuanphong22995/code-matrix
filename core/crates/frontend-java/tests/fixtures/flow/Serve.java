package fixture;

// Data-flow fixture: line numbers match the feature scenarios.
class Serve {




















































































    void serve() {
        int limit = 5;

        Runnable f = () -> {
            int n = limit;
            print(n + limit);
        };
        f.run();
        print(limit);
    }
}
