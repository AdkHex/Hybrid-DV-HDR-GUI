use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct ProcessingState {
    pub cancel_flag: Arc<Mutex<bool>>,
}
