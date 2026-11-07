class Store:
    limit = 3

    def save(self, item):
        self.items = item
        return self.items
