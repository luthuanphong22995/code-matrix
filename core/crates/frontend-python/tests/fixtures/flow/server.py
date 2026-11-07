def handle(req):
    code = read()
    if req.ok:
        send(code)
    else:
        log(code)

def route(req):
    status = 200
    if req.missing:
        status = 404
    elif req.bad:
        status = 400
    write(status)
