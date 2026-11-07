from .base import Base
from ..util import read_file


class User(Base):
    def load(self):
        self.save()
        return read_file

    def touch(self):
        self.load()
