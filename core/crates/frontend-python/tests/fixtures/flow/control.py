def control(xs, mode):
    n = 0
    while n < 10:
        if n in xs:
            break
        n += 1
    else:
        n = -1
    try:
        n = parse(n)
    except ValueError as err:
        log(err)
    finally:
        done(n)
    match mode:
        case 1:
            n = 2
        case _:
            pass
    with open(n) as fh:
        import os
        if (m := fh.read()):
            del m
    return n
