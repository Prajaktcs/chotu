//! Initial meal inserts shared by Signal and the app API.

use anyhow::Result;
use chotu_common::{AssignedFoodTags, FoodSignalContext, NutritionEstimation};
use sqlx::SqlitePool;

/// Insert food_log + tags + day summary in one transaction so a tag failure
/// cannot leave an orphaned meal or a skipped summary bump. Signal meals carry
/// their conversation context; app meals have none.
pub async fn insert_food_log(
    pool: &SqlitePool,
    log_id: &str,
    log_ts: chrono::DateTime<chrono::Utc>,
    family_member_id: &str,
    food_description: &str,
    est: &NutritionEstimation,
    date_str: &str,
    assigned: &AssignedFoodTags,
    context: Option<&FoodSignalContext<'_>>,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO food_log (id, timestamp, family_member_id, raw_text_description, \
         estimated_calories, estimated_protein, estimated_carbs, estimated_fats, \
         estimated_omega_3_dha_mg, estimated_cholesterol_mg, estimated_saturated_fat_g, estimated_unsaturated_fat_g, estimated_triglycerides_mg, \
         estimated_iron_mg, estimated_vitamin_b_mg, estimated_vitamin_c_mg, \
         estimated_sugar_g, estimated_fiber_g, estimated_sodium_mg, estimated_potassium_mg, estimated_calcium_mg, \
         estimated_magnesium_mg, estimated_zinc_mg, estimated_vitamin_a_mcg, estimated_vitamin_d_mcg, estimated_vitamin_e_mg, \
         estimated_vitamin_k_mcg, estimated_caffeine_mg, estimated_trans_fat_g) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(log_id)
    .bind(log_ts)
    .bind(family_member_id)
    .bind(food_description)
    .bind(est.total_calories)
    .bind(est.protein_grams)
    .bind(est.carbs_grams)
    .bind(est.fats_grams)
    .bind(est.omega_3_dha_mg)
    .bind(est.cholesterol_mg)
    .bind(est.saturated_fat_g)
    .bind(est.unsaturated_fat_g)
    .bind(est.triglycerides_mg)
    .bind(est.iron_mg)
    .bind(est.vitamin_b_mg)
    .bind(est.vitamin_c_mg)
    .bind(est.sugar_g)
    .bind(est.fiber_g)
    .bind(est.sodium_mg)
    .bind(est.potassium_mg)
    .bind(est.calcium_mg)
    .bind(est.magnesium_mg)
    .bind(est.zinc_mg)
    .bind(est.vitamin_a_mcg)
    .bind(est.vitamin_d_mcg)
    .bind(est.vitamin_e_mg)
    .bind(est.vitamin_k_mcg)
    .bind(est.caffeine_mg)
    .bind(est.trans_fat_g)
    .execute(&mut *tx)
    .await?;

    chotu_common::insert_food_log_tags(&mut tx, log_id, assigned).await?;

    sqlx::query(
        r#"
                INSERT INTO health_family_summary (
                    date,
                    family_member_id,
                    total_calories_ingested,
                    protein_grams,
                    carbs_grams,
                    fats_grams,
                    omega_3_dha_mg,
                    cholesterol_mg,
                    saturated_fat_g,
                    unsaturated_fat_g,
                    triglycerides_mg,
                    iron_mg,
                    vitamin_b_mg,
                    vitamin_c_mg,
                    sugar_g,
                    fiber_g,
                    sodium_mg,
                    potassium_mg,
                    calcium_mg,
                    magnesium_mg,
                    zinc_mg,
                    vitamin_a_mcg,
                    vitamin_d_mcg,
                    vitamin_e_mg,
                    vitamin_k_mcg,
                    caffeine_mg,
                    trans_fat_g,
                    step_count,
                    active_calories_burned
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                ON CONFLICT(date, family_member_id) DO UPDATE SET
                    total_calories_ingested = health_family_summary.total_calories_ingested + excluded.total_calories_ingested,
                    protein_grams = health_family_summary.protein_grams + excluded.protein_grams,
                    carbs_grams = health_family_summary.carbs_grams + excluded.carbs_grams,
                    fats_grams = health_family_summary.fats_grams + excluded.fats_grams,
                    omega_3_dha_mg = health_family_summary.omega_3_dha_mg + excluded.omega_3_dha_mg,
                    cholesterol_mg = health_family_summary.cholesterol_mg + excluded.cholesterol_mg,
                    saturated_fat_g = health_family_summary.saturated_fat_g + excluded.saturated_fat_g,
                    unsaturated_fat_g = health_family_summary.unsaturated_fat_g + excluded.unsaturated_fat_g,
                    triglycerides_mg = health_family_summary.triglycerides_mg + excluded.triglycerides_mg,
                    iron_mg = health_family_summary.iron_mg + excluded.iron_mg,
                    vitamin_b_mg = health_family_summary.vitamin_b_mg + excluded.vitamin_b_mg,
                    vitamin_c_mg = health_family_summary.vitamin_c_mg + excluded.vitamin_c_mg,
                    sugar_g = health_family_summary.sugar_g + excluded.sugar_g,
                    fiber_g = health_family_summary.fiber_g + excluded.fiber_g,
                    sodium_mg = health_family_summary.sodium_mg + excluded.sodium_mg,
                    potassium_mg = health_family_summary.potassium_mg + excluded.potassium_mg,
                    calcium_mg = health_family_summary.calcium_mg + excluded.calcium_mg,
                    magnesium_mg = health_family_summary.magnesium_mg + excluded.magnesium_mg,
                    zinc_mg = health_family_summary.zinc_mg + excluded.zinc_mg,
                    vitamin_a_mcg = health_family_summary.vitamin_a_mcg + excluded.vitamin_a_mcg,
                    vitamin_d_mcg = health_family_summary.vitamin_d_mcg + excluded.vitamin_d_mcg,
                    vitamin_e_mg = health_family_summary.vitamin_e_mg + excluded.vitamin_e_mg,
                    vitamin_k_mcg = health_family_summary.vitamin_k_mcg + excluded.vitamin_k_mcg,
                    caffeine_mg = health_family_summary.caffeine_mg + excluded.caffeine_mg,
                    trans_fat_g = health_family_summary.trans_fat_g + excluded.trans_fat_g;
                "#,
    )
    .bind(date_str)
    .bind(family_member_id)
    .bind(est.total_calories)
    .bind(est.protein_grams)
    .bind(est.carbs_grams)
    .bind(est.fats_grams)
    .bind(est.omega_3_dha_mg)
    .bind(est.cholesterol_mg)
    .bind(est.saturated_fat_g)
    .bind(est.unsaturated_fat_g)
    .bind(est.triglycerides_mg)
    .bind(est.iron_mg)
    .bind(est.vitamin_b_mg)
    .bind(est.vitamin_c_mg)
    .bind(est.sugar_g)
    .bind(est.fiber_g)
    .bind(est.sodium_mg)
    .bind(est.potassium_mg)
    .bind(est.calcium_mg)
    .bind(est.magnesium_mg)
    .bind(est.zinc_mg)
    .bind(est.vitamin_a_mcg)
    .bind(est.vitamin_d_mcg)
    .bind(est.vitamin_e_mg)
    .bind(est.vitamin_k_mcg)
    .bind(est.caffeine_mg)
    .bind(est.trans_fat_g)
    .execute(&mut *tx)
    .await?;

    if let Some(context) = context {
        chotu_common::write_food_signal_context(&mut *tx, log_id, context).await?;
    }
    tx.commit().await?;
    Ok(())
}
