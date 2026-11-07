DEFAULT_PATH = "config.toml"


def parse_config(path):
    total = 0
    for n in open(path):
        total = total + n
    unused = DEFAULT_PATH
    if read() > 0:
        return total
    log(path)
    return 0
