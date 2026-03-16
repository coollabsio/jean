use rand::seq::SliceRandom;

/// List of adjectives for workspace names (~120 entries for ~14,400 combinations)
const ADJECTIVES: &[&str] = &[
    "swift", "quiet", "bright", "fuzzy", "gentle", "bold", "calm", "eager", "fancy", "grand",
    "happy", "jolly", "keen", "lively", "merry", "noble", "proud", "quick", "rapid", "sharp",
    "smart", "snowy", "sunny", "sweet", "vivid", "warm", "wise", "young", "zesty", "agile",
    "brave", "clever", "daring", "epic", "fair", "golden", "honest", "iconic", "jade", "kindly",
    "loyal", "mighty", "neat", "open", "prime", "royal", "solid", "tidy", "ultra", "vital",
    "amber", "azure", "brisk", "coral", "crisp", "dusty", "elfin", "fiery", "fleet", "frosty",
    "gleam", "gusty", "hazy", "icy", "ivory", "jasper", "lunar", "maple", "misty", "mossy",
    "oaken", "opal", "peach", "plush", "polar", "rosy", "rusty", "sage", "sandy", "silky", "smoky",
    "spry", "stark", "steel", "stony", "stormy", "tawny", "terra", "vast", "velvet", "wild",
    "windy", "woody", "ashen", "cedar", "chalk", "dawn", "dusk", "ember", "frost", "gilt", "hazel",
    "honey", "indigo", "lemon", "lilac", "mint", "onyx", "pearl", "plum", "quartz", "ruby",
    "slate", "stone", "thorn", "topaz", "tulip", "umber", "zinc", "birch",
];

/// List of animals for workspace names (~120 entries for ~14,400 combinations)
const ANIMALS: &[&str] = &[
    "tiger", "falcon", "otter", "eagle", "wolf", "bear", "lion", "hawk", "fox", "deer", "owl",
    "swan", "crane", "whale", "shark", "raven", "heron", "finch", "robin", "wren", "hound",
    "horse", "moose", "bison", "panda", "koala", "lemur", "sloth", "gecko", "viper", "cobra",
    "python", "salmon", "trout", "bass", "perch", "carp", "tuna", "squid", "crab", "seal",
    "walrus", "orca", "dolphin", "pelican", "parrot", "toucan", "condor", "osprey", "badger",
    "alpaca", "bobcat", "camel", "cheetah", "clam", "corgi", "coyote", "dingo", "dove", "drake",
    "egret", "elk", "ferret", "flamingo", "gannet", "gazelle", "gibbon", "goose", "grouse", "gull",
    "ibis", "iguana", "impala", "jackal", "jaguar", "kite", "lark", "linnet", "llama", "locust",
    "lynx", "macaw", "marten", "mink", "moth", "myna", "newt", "okapi", "oriole", "panther",
    "pigeon", "puffin", "quail", "rabbit", "raccoon", "ram", "shrike", "skunk", "snipe", "spider",
    "stork", "swift", "tern", "thrush", "toad", "turtle", "urchin", "wasp", "weasel", "yak",
    "zebra", "beetle", "mantis", "mole", "pika", "rook", "wombat", "starling",
];

/// Generate a random workspace name in the format "adjective-animal"
pub fn generate_workspace_name() -> String {
    let mut rng = rand::thread_rng();

    let adjective = ADJECTIVES.choose(&mut rng).unwrap_or(&"swift");
    let animal = ANIMALS.choose(&mut rng).unwrap_or(&"falcon");

    format!("{adjective}-{animal}")
}

/// Generate a unique workspace name that doesn't exist in the given list
pub fn generate_unique_workspace_name<F>(exists_fn: F) -> String
where
    F: Fn(&str) -> bool,
{
    let mut attempts = 0;
    const MAX_ATTEMPTS: u32 = 100;

    loop {
        let name = generate_workspace_name();

        if !exists_fn(&name) {
            return name;
        }

        attempts += 1;
        if attempts >= MAX_ATTEMPTS {
            // Fallback: append a random suffix
            let suffix: u32 = rand::random::<u32>() % 1000;
            return format!("{name}-{suffix}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_workspace_name_format() {
        let name = generate_workspace_name();
        assert!(name.contains('-'), "Name should contain a hyphen");

        let parts: Vec<&str> = name.split('-').collect();
        assert_eq!(parts.len(), 2, "Name should have exactly two parts");

        assert!(
            ADJECTIVES.contains(&parts[0]),
            "First part should be an adjective"
        );
        assert!(
            ANIMALS.contains(&parts[1]),
            "Second part should be an animal"
        );
    }

    #[test]
    fn test_generate_unique_workspace_name() {
        let existing = ["swift-falcon".to_string(), "calm-eagle".to_string()];

        let name = generate_unique_workspace_name(|n| existing.contains(&n.to_string()));

        assert!(!existing.contains(&name), "Name should be unique");
    }

    #[test]
    fn test_generate_unique_workspace_name_fallback() {
        // If all names are "taken", it should add a suffix
        let name = generate_unique_workspace_name(|_| true);

        // Should have a numeric suffix
        let parts: Vec<&str> = name.split('-').collect();
        assert!(
            parts.len() >= 3,
            "Should have a numeric suffix when all names taken"
        );
    }
}
