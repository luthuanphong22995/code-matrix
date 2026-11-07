import os
import app.config as cfg
from app.config import Config, parse_config
from .util import read_file
from app import models


def main() -> Config:
    c: Config = parse_config()
    cfg.parse_env()
    read_file("settings.toml")
    fetch_data()
    os.getcwd()

    def helper():
        return models

    return c
