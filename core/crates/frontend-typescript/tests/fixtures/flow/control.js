// Data-flow fixture: `var` hoisting and the remaining JavaScript control flow.

function hoisted(c) {
  print(v);
  if (c) {
    var v = 1;
  }
  print(v);
}

function uninit() {
  let n;
  return n;
}

function loops(o) {
  let acc = 0;
  do {
    acc = acc + 1;
  } while (acc < 3);
  for (let i = 0; i < 3; i++) {
    acc = acc + i;
  }
  outer: for (const k in o) {
    for (;;) {
      acc = acc + 1;
      continue outer;
    }
  }
  return acc;
}

function pick(k) {
  let r = 0;
  switch (k) {
    case 1:
      r = 1;
    case 2:
      r = r + 1;
      break;
  }
  return r;
}

function guarded() {
  let x = 0;
  try {
    x = risky();
  } catch (e) {
    log(e, x);
  } finally {
    use(x);
  }
}

function swap(o) {
  const { a, b = a } = o;
  let p = 1, q = 2;
  [p, q] = [q, p];
  return b + p + q;
}
