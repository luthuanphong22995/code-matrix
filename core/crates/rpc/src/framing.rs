//! LSP-style `Content-Length` framing.

use std::io::{self, BufRead, Write};

/// Reads one frame body. `Ok(None)` on clean EOF before a header.
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut len = None;
    let mut started = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return if started {
                Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "EOF inside frame header",
                ))
            } else {
                Ok(None)
            };
        }
        started = true;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        // ponytail: other headers (Content-Type) are ignored.
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("Content-Length") {
                len = Some(value.trim().parse::<usize>().map_err(|e| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("bad Content-Length: {e}"),
                    )
                })?);
            }
        }
    }
    let len =
        len.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing Content-Length"))?;
    let mut body = vec![0; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

/// Writes one frame (header + body) and flushes.
pub fn write_message(writer: &mut impl Write, body: &[u8]) -> io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(body)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(body: &[u8]) {
        let mut buf = Vec::new();
        write_message(&mut buf, body).unwrap();
        let mut reader = buf.as_slice();
        assert_eq!(read_message(&mut reader).unwrap().as_deref(), Some(body));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn round_trips_0_1_and_1mib_payloads() {
        round_trip(b"");
        round_trip(b"x");
        round_trip(&vec![b'a'; 1 << 20]);
    }

    #[test]
    fn reads_two_frames_back_to_back() {
        let mut buf = Vec::new();
        write_message(&mut buf, b"{\"a\":1}").unwrap();
        write_message(&mut buf, b"{\"b\":2}").unwrap();
        let mut reader = buf.as_slice();
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), b"{\"a\":1}");
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), b"{\"b\":2}");
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn clean_eof_is_none() {
        assert_eq!(read_message(&mut &b""[..]).unwrap(), None);
    }

    #[test]
    fn truncated_body_is_err() {
        assert!(read_message(&mut &b"Content-Length: 10\r\n\r\nabc"[..]).is_err());
    }

    #[test]
    fn missing_or_invalid_content_length_is_err() {
        assert!(read_message(&mut &b"Content-Type: x\r\n\r\n{}"[..]).is_err());
        assert!(read_message(&mut &b"Content-Length: nope\r\n\r\n{}"[..]).is_err());
        assert!(read_message(&mut &b"Content-Length: 2\r\n"[..]).is_err());
    }
}
