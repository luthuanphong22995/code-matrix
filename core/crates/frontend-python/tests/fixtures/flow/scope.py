counter = 0


def bump():
    global counter
    counter += 1
    return counter


def outer():
    total = 0
    def add():
        nonlocal total
        total += 1
    add()
    return total
