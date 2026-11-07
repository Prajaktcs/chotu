//! What a correction or a photo update of one logged meal sends to the model
//! and keeps afterwards. Signal's meal replies and `/correctfood` and the app's
//! `POST /v1/food/{id}/correct` share these, so both carry the same facts.

use chotu_common::{FoodCorrectionAnalysis, NutritionEstimation};

/// The meal's new values for [`crate::revise_food_log`].
#[derive(Debug, Clone, PartialEq)]
pub struct MealRevision {
    pub description: String,
    pub nutrition: NutritionEstimation,
    /// The meal's known user facts, this change appended last.
    pub facts: String,
    /// Tag evidence: the corrected meal plus earlier explicit exclusions.
    pub tag_context: String,
}

/// The `original_description` for `GeminiClient::correct_food_estimation`.
pub fn correction_input(description: &str, user_facts: &str) -> String {
    format!(
        "Current meal: {description}\nKnown user facts (later corrections take precedence): {user_facts}"
    )
}

/// A text correction's result. `Err(question)` when the model asked to
/// clarify: the meal must stay unchanged.
pub fn text_correction(
    user_facts: &str,
    correction: &str,
    analysis: FoodCorrectionAnalysis,
) -> Result<MealRevision, String> {
    if let Some(question) = analysis.clarification {
        let question = question.trim();
        return Err(if question.is_empty() {
            "Please clarify which ingredient or portion should change.".to_owned()
        } else {
            question.to_owned()
        });
    }
    let tag_context =
        chotu_common::reconcile_food_tag_context(&analysis.description, user_facts, correction);
    Ok(MealRevision {
        facts: format!("{user_facts}\nCorrection: {correction}"),
        description: analysis.description,
        nutrition: analysis.nutrition,
        tag_context,
    })
}

/// The vision caption for a photo that updates one existing meal.
pub fn photo_update_caption(description: &str, user_facts: &str, caption: &str) -> String {
    format!(
        "This photo updates ONE existing meal; preserve its consumed portion and supplied ingredients. \
         Previous meal estimate: {description}. Known user facts (later corrections take precedence): {user_facts}. \
         New caption: {caption}. Use the photo to fill missing details, not replace explicit facts."
    )
}

/// A photo update's result, from the photo's description and nutrition.
pub fn photo_update(
    user_facts: &str,
    caption: &str,
    description: String,
    nutrition: NutritionEstimation,
) -> MealRevision {
    let facts = if caption.is_empty() {
        user_facts.to_owned()
    } else {
        format!("{user_facts}\nPhoto caption: {caption}")
    };
    let tag_context = chotu_common::reconcile_food_tag_context(&description, user_facts, caption);
    MealRevision {
        description,
        nutrition,
        facts,
        tag_context,
    }
}
