package fixture;

// Data-flow fixture: line numbers match the feature scenarios.
class Config {
    static String defaultPath = "config.yaml";

    static int[] open(String path) { return new int[0]; }

    static int read() { return 0; }

    int parseConfig(String path) {
        int total = 0;
        for (int n : open(path)) {
            total = total + n;
        }
        String unused = defaultPath;
        if (read() > 0) {
            return total;
        }
        log(path);
        return 0;
    }

    static void log(String s) {}
}
