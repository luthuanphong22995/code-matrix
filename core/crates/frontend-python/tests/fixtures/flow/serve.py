def serve(items):
    limit = 5
    ok = [x for x in items if x < limit]
    f = lambda: limit + 1
    def inner():
        return limit
    print(limit, ok, f, inner)
