//! Buffer de salida por sesión: lo que se repone cuando un cliente se conecta tarde.
use std::collections::VecDeque;

/// Mismo tope que el daemon de Node (en unidades UTF-16, como `string.length`).
pub const MAX_BUFFER_CHARS: usize = 400_000;

#[derive(Clone)]
pub struct Chunk {
    pub seq: u64,
    pub data: String,
}

pub struct Buffer {
    chunks: VecDeque<Chunk>,
    size: usize,
    pub seq: u64,
}

impl Buffer {
    pub fn new(seq: u64) -> Self {
        Buffer { chunks: VecDeque::new(), size: 0, seq }
    }

    pub fn push(&mut self, data: String) -> Chunk {
        self.seq += 1;
        let chunk = Chunk { seq: self.seq, data };
        self.size += chunk.data.encode_utf16().count();
        self.chunks.push_back(chunk.clone());
        while self.size > MAX_BUFFER_CHARS && self.chunks.len() > 1 {
            if let Some(viejo) = self.chunks.pop_front() {
                self.size -= viejo.data.encode_utf16().count();
            }
        }
        chunk
    }

    pub fn snapshot(&self) -> Vec<Chunk> {
        self.chunks.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numera_y_conserva() {
        let mut b = Buffer::new(5);
        assert_eq!(b.push("a".into()).seq, 6);
        assert_eq!(b.push("b".into()).seq, 7);
        assert_eq!(b.snapshot().len(), 2);
        assert_eq!(b.seq, 7);
    }

    #[test]
    fn descarta_lo_viejo_pero_deja_al_menos_uno() {
        let mut b = Buffer::new(0);
        for _ in 0..10 {
            b.push("x".repeat(100_000));
        }
        let s = b.snapshot();
        assert!(s.len() <= 4);
        assert_eq!(s.last().map(|c| c.seq), Some(10));
        let mut solo = Buffer::new(0);
        solo.push("y".repeat(MAX_BUFFER_CHARS + 10));
        assert_eq!(solo.snapshot().len(), 1);
    }
}
