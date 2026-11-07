package fixture;

// Data-flow fixture: line numbers match the feature scenarios.
class Server {
























    void handle(boolean ready) {
        int status = 200;
        log(status);
        if (!ready) {
            status = 404;
        }

        write(status);



        int code = read();
        if (ready) {
            // the code is ready
            write(code);
        } else {
            // not ready
            log(code);
        }
    }
}
