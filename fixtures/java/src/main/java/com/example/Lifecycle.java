package com.example;

public interface Lifecycle {
    void stop();
}

enum Status {
    RUNNING,
    STOPPED;

    Status next() {
        return STOPPED;
    }
}

class Outer {
    static class Inner {
        Status status() {
            return Status.RUNNING;
        }
    }
}

@interface Marker {
}
