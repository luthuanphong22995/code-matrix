//! The frontends a run dispatches to, by file extension.

use ir::Frontend;

pub struct FrontendRegistry {
    frontends: Vec<Box<dyn Frontend>>,
}

impl FrontendRegistry {
    pub fn new(frontends: Vec<Box<dyn Frontend>>) -> Self {
        Self { frontends }
    }

    /// The frontend handling `ext` (without the dot); the first registered wins on a clash.
    pub fn by_extension(&self, ext: &str) -> Option<&dyn Frontend> {
        self.frontends
            .iter()
            .find(|frontend| frontend.extensions().contains(&ext))
            .map(Box::as_ref)
    }

    /// Distinct languages, in registration order.
    pub fn languages(&self) -> Vec<&'static str> {
        let mut languages = Vec::new();
        for frontend in &self.frontends {
            if !languages.contains(&frontend.language()) {
                languages.push(frontend.language());
            }
        }
        languages
    }

    /// The first registered frontend for `language`.
    pub(crate) fn by_language(&self, language: &str) -> Option<&dyn Frontend> {
        self.frontends
            .iter()
            .find(|frontend| frontend.language() == language)
            .map(Box::as_ref)
    }
}
