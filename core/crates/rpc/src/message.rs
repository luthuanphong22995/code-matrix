//! JSON-RPC 2.0 message types.

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

/// The `jsonrpc` member: always serialized as `"2.0"`, ignored on input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Version;

impl Serialize for Version {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str("2.0")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    #[serde(skip_deserializing)]
    pub jsonrpc: Version,
    pub id: Value,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    #[serde(skip_deserializing)]
    pub jsonrpc: Version,
    pub method: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub params: Value,
}

impl Notification {
    pub fn new(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: Version,
            method: method.to_owned(),
            params,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    #[serde(skip_deserializing)]
    pub jsonrpc: Version,
    pub id: Value,
    #[serde(flatten)]
    pub outcome: Outcome,
}

/// Serialized as the response's `result` or `error` member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Result(Value),
    Error(ResponseError),
}

impl Response {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: Version,
            id,
            outcome: Outcome::Result(result),
        }
    }

    pub fn err(id: Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            jsonrpc: Version,
            id,
            outcome: Outcome::Error(ResponseError {
                code,
                message: message.into(),
                data,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResponseError {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A message received by the server. Request comes first so an `id` selects it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
    Request(Request),
    Notification(Notification),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn null_result_response() {
        let response = Response::ok(json!(1), Value::Null);
        let text = serde_json::to_string(&response).unwrap();
        assert_eq!(text, r#"{"jsonrpc":"2.0","id":1,"result":null}"#);
        assert_eq!(serde_json::from_str::<Response>(&text).unwrap(), response);
    }

    #[test]
    fn error_response() {
        let response = Response::err(Value::Null, -32001, "InvalidRoots", Some(json!("/x")));
        let text = serde_json::to_string(&response).unwrap();
        assert_eq!(
            text,
            r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"InvalidRoots","data":"/x"}}"#
        );
        assert_eq!(serde_json::from_str::<Response>(&text).unwrap(), response);
        assert_eq!(
            serde_json::to_string(&Response::err(json!(2), -32601, "x", None)).unwrap(),
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"x"}}"#
        );
    }

    #[test]
    fn notification_serializes_with_version() {
        let note = Notification::new("$/status", json!({"state": "ready"}));
        assert_eq!(
            serde_json::to_string(&note).unwrap(),
            r#"{"jsonrpc":"2.0","method":"$/status","params":{"state":"ready"}}"#
        );
    }

    #[test]
    fn id_selects_request() {
        let msg: Message =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":1,"method":"shutdown"}"#).unwrap();
        assert!(matches!(msg, Message::Request(Request { id, .. }) if id == json!(1)));
        let msg: Message =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":null,"method":"shutdown"}"#).unwrap();
        assert!(matches!(
            msg,
            Message::Request(Request {
                id: Value::Null,
                ..
            })
        ));
        let msg: Message = serde_json::from_str(r#"{"jsonrpc":"2.0","method":"x"}"#).unwrap();
        assert!(matches!(msg, Message::Notification(_)));
    }
}
