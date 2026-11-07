package db

type Conn struct {
	addr string
}

func Open() *Conn {
	return &Conn{addr: "localhost"}
}
