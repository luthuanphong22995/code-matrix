// Data-flow fixture: line numbers match the feature scenarios.


























class Server {
  handle(ready) {
    let status = 200;
    log(status);
    if (!ready) {
      status = 404;
    }

    write(status);



    const code = read();
    if (ready) {
      // the code is ready
      write(code);
    } else {
      // not ready
      log(code);
    }
  }
}
