class Config:
    pass


def parse_config() -> Config:
    parse_env()
    return Config()


def parse_env():
    return {}
