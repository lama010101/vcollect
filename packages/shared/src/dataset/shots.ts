// =============================================================================
// @twio/shared — the 100-shot creative plan (PRD §27)
//
// Faithful transcription of the PRD §27 CSV. This is the single source of truth
// for the shots table seed. Do NOT edit individual rows here to "tune" the plan
// without coordinating with the creative direction.
// =============================================================================

export interface ShotDatasetRow {
  shotNumber: number;
  section: string;
  searchQuery: string;
  visualDescription: string;
  targetSeconds: number;
  priority: number;
}

export const SHOT_DATASET: readonly ShotDatasetRow[] = [
  { shotNumber: 1, section: "INTRO", searchQuery: "sunlight through trees cinematic", visualDescription: "Sunlight filtering through trees", targetSeconds: 2, priority: 5 },
  { shotNumber: 2, section: "INTRO", searchQuery: "sunny landscape people outdoors", visualDescription: "Wide sunny landscape", targetSeconds: 2, priority: 5 },
  { shotNumber: 3, section: "INTRO", searchQuery: "child looking sunlight outdoors", visualDescription: "Child looking toward sunlight", targetSeconds: 2, priority: 5 },
  { shotNumber: 4, section: "INTRO", searchQuery: "children running grass", visualDescription: "Children running through grass", targetSeconds: 2, priority: 5 },
  { shotNumber: 5, section: "INTRO", searchQuery: "children running outdoors", visualDescription: "Group of children running", targetSeconds: 3, priority: 5 },
  { shotNumber: 6, section: "INTRO", searchQuery: "children laughing playing", visualDescription: "Children laughing while playing", targetSeconds: 2, priority: 5 },
  { shotNumber: 7, section: "INTRO", searchQuery: "kids running camera outdoors", visualDescription: "Children running toward camera", targetSeconds: 2, priority: 5 },
  { shotNumber: 8, section: "VERSE_1", searchQuery: "children playing football outdoors", visualDescription: "Children playing football", targetSeconds: 3, priority: 5 },
  { shotNumber: 9, section: "VERSE_1", searchQuery: "children playground laughing", visualDescription: "Children playing on playground", targetSeconds: 3, priority: 4 },
  { shotNumber: 10, section: "VERSE_1", searchQuery: "kids friendship running", visualDescription: "Two children running together", targetSeconds: 3, priority: 5 },
  { shotNumber: 11, section: "VERSE_1", searchQuery: "children laughing close up", visualDescription: "Natural child laughter", targetSeconds: 2, priority: 5 },
  { shotNumber: 12, section: "VERSE_1", searchQuery: "children sharing toy", visualDescription: "Children sharing a toy", targetSeconds: 3, priority: 5 },
  { shotNumber: 13, section: "VERSE_1", searchQuery: "children helping each other", visualDescription: "Child helping another child", targetSeconds: 3, priority: 5 },
  { shotNumber: 14, section: "VERSE_1", searchQuery: "children high five outdoors", visualDescription: "Children celebrating together", targetSeconds: 2, priority: 4 },
  { shotNumber: 15, section: "VERSE_1", searchQuery: "diverse children laughing", visualDescription: "Diverse children laughing", targetSeconds: 3, priority: 5 },
  { shotNumber: 16, section: "VERSE_1", searchQuery: "family playing outdoors", visualDescription: "Family playing together", targetSeconds: 3, priority: 4 },
  { shotNumber: 17, section: "VERSE_1", searchQuery: "happy child smiling outdoors", visualDescription: "Child smiling naturally", targetSeconds: 2, priority: 5 },
  { shotNumber: 18, section: "VERSE_1", searchQuery: "children friends running", visualDescription: "Friends running together", targetSeconds: 3, priority: 4 },
  { shotNumber: 19, section: "PRE_CHORUS_1", searchQuery: "person helping stranger street", visualDescription: "Person notices someone needing help", targetSeconds: 3, priority: 5 },
  { shotNumber: 20, section: "PRE_CHORUS_1", searchQuery: "helping person outdoors", visualDescription: "Person helping another person", targetSeconds: 3, priority: 5 },
  { shotNumber: 21, section: "PRE_CHORUS_1", searchQuery: "helping elderly person walking", visualDescription: "Helping an elderly person", targetSeconds: 3, priority: 5 },
  { shotNumber: 22, section: "PRE_CHORUS_1", searchQuery: "person giving food stranger", visualDescription: "Person giving something to another", targetSeconds: 3, priority: 5 },
  { shotNumber: 23, section: "PRE_CHORUS_1", searchQuery: "stranger smiling kindness", visualDescription: "Recipient smiling", targetSeconds: 2, priority: 5 },
  { shotNumber: 24, section: "PRE_CHORUS_1", searchQuery: "people walking together smiling", visualDescription: "Two people walking together", targetSeconds: 3, priority: 4 },
  { shotNumber: 25, section: "CHORUS_1", searchQuery: "children playing wide shot", visualDescription: "Children playing in wide shot", targetSeconds: 3, priority: 5 },
  { shotNumber: 26, section: "CHORUS_1", searchQuery: "happy children outdoors", visualDescription: "Children smiling and playing", targetSeconds: 2, priority: 5 },
  { shotNumber: 27, section: "CHORUS_1", searchQuery: "family laughing outdoors", visualDescription: "Family laughing together", targetSeconds: 3, priority: 4 },
  { shotNumber: 28, section: "CHORUS_1", searchQuery: "friends running laughing", visualDescription: "Friends running together", targetSeconds: 3, priority: 4 },
  { shotNumber: 29, section: "CHORUS_1", searchQuery: "children dancing outdoors", visualDescription: "Children dancing", targetSeconds: 3, priority: 5 },
  { shotNumber: 30, section: "CHORUS_1", searchQuery: "diverse people community outdoors", visualDescription: "Diverse community together", targetSeconds: 3, priority: 5 },
  { shotNumber: 31, section: "CHORUS_1", searchQuery: "people celebrating outdoors", visualDescription: "People celebrating", targetSeconds: 3, priority: 4 },
  { shotNumber: 32, section: "CHORUS_1", searchQuery: "community gathering happy", visualDescription: "Community gathering", targetSeconds: 3, priority: 4 },
  { shotNumber: 33, section: "CHORUS_1", searchQuery: "people dancing outdoor celebration", visualDescription: "People dancing", targetSeconds: 3, priority: 5 },
  { shotNumber: 34, section: "CHORUS_1", searchQuery: "children jumping happy", visualDescription: "Children jumping", targetSeconds: 2, priority: 5 },
  { shotNumber: 35, section: "CHORUS_1", searchQuery: "large group celebration outdoors", visualDescription: "Large outdoor celebration", targetSeconds: 3, priority: 5 },
  { shotNumber: 36, section: "CHORUS_1", searchQuery: "aerial crowd people outdoors", visualDescription: "Aerial crowd/community", targetSeconds: 3, priority: 4 },
  { shotNumber: 37, section: "POST_CHORUS", searchQuery: "dancing feet outdoor", visualDescription: "Dancing feet", targetSeconds: 1.5, priority: 4 },
  { shotNumber: 38, section: "POST_CHORUS", searchQuery: "child dancing happy", visualDescription: "Child dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 39, section: "POST_CHORUS", searchQuery: "friends dancing outdoors", visualDescription: "Friends dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 40, section: "POST_CHORUS", searchQuery: "group dancing celebration", visualDescription: "Group dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 41, section: "POST_CHORUS", searchQuery: "person dancing spinning", visualDescription: "Person spinning while dancing", targetSeconds: 2, priority: 4 },
  { shotNumber: 42, section: "POST_CHORUS", searchQuery: "people jumping celebration", visualDescription: "People jumping", targetSeconds: 2, priority: 5 },
  { shotNumber: 43, section: "POST_CHORUS", searchQuery: "crowd dancing outdoor", visualDescription: "Crowd dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 44, section: "VERSE_2", searchQuery: "person sitting alone park", visualDescription: "Person sitting alone", targetSeconds: 3, priority: 5 },
  { shotNumber: 45, section: "VERSE_2", searchQuery: "person waiting street", visualDescription: "Person waiting alone", targetSeconds: 3, priority: 4 },
  { shotNumber: 46, section: "VERSE_2", searchQuery: "people meeting street", visualDescription: "Two people meeting", targetSeconds: 3, priority: 5 },
  { shotNumber: 47, section: "VERSE_2", searchQuery: "strangers smiling", visualDescription: "Two strangers smiling", targetSeconds: 2, priority: 5 },
  { shotNumber: 48, section: "VERSE_2", searchQuery: "people greeting each other", visualDescription: "People greeting", targetSeconds: 2, priority: 5 },
  { shotNumber: 49, section: "VERSE_2", searchQuery: "strangers talking smiling", visualDescription: "Strangers talking", targetSeconds: 3, priority: 5 },
  { shotNumber: 50, section: "VERSE_2", searchQuery: "person helping stranger", visualDescription: "Person helping stranger", targetSeconds: 3, priority: 5 },
  { shotNumber: 51, section: "VERSE_2", searchQuery: "two people laughing outdoors", visualDescription: "Two people laughing", targetSeconds: 3, priority: 5 },
  { shotNumber: 52, section: "VERSE_2", searchQuery: "friends walking together", visualDescription: "People walking together", targetSeconds: 3, priority: 4 },
  { shotNumber: 53, section: "VERSE_2", searchQuery: "people community outdoors", visualDescription: "Community wide shot", targetSeconds: 3, priority: 4 },
  { shotNumber: 54, section: "PRE_CHORUS_2", searchQuery: "child smiling outdoors", visualDescription: "Child smiling", targetSeconds: 2, priority: 5 },
  { shotNumber: 55, section: "PRE_CHORUS_2", searchQuery: "adult smiling outdoors", visualDescription: "Adult smiling", targetSeconds: 2, priority: 4 },
  { shotNumber: 56, section: "PRE_CHORUS_2", searchQuery: "friends smiling outdoors", visualDescription: "Two people connecting", targetSeconds: 2, priority: 5 },
  { shotNumber: 57, section: "CHORUS_2", searchQuery: "children playing outdoors", visualDescription: "Children playing", targetSeconds: 3, priority: 5 },
  { shotNumber: 58, section: "CHORUS_2", searchQuery: "happy family outdoors", visualDescription: "Family outdoors", targetSeconds: 3, priority: 4 },
  { shotNumber: 59, section: "CHORUS_2", searchQuery: "diverse friends laughing", visualDescription: "Diverse friends laughing", targetSeconds: 3, priority: 5 },
  { shotNumber: 60, section: "CHORUS_2", searchQuery: "children dancing", visualDescription: "Children dancing", targetSeconds: 3, priority: 5 },
  { shotNumber: 61, section: "CHORUS_2", searchQuery: "outdoor celebration people", visualDescription: "Outdoor celebration", targetSeconds: 3, priority: 5 },
  { shotNumber: 62, section: "CHORUS_2", searchQuery: "community festival people", visualDescription: "Community festival", targetSeconds: 3, priority: 5 },
  { shotNumber: 63, section: "CHORUS_2", searchQuery: "people dancing celebration", visualDescription: "People dancing", targetSeconds: 3, priority: 5 },
  { shotNumber: 64, section: "CHORUS_2", searchQuery: "large group people outdoors", visualDescription: "Large group outdoors", targetSeconds: 3, priority: 5 },
  { shotNumber: 65, section: "CHORUS_2", searchQuery: "aerial city sunny", visualDescription: "Sunny aerial city", targetSeconds: 3, priority: 4 },
  { shotNumber: 66, section: "CHORUS_2", searchQuery: "aerial nature sunlight", visualDescription: "Nature aerial", targetSeconds: 3, priority: 4 },
  { shotNumber: 67, section: "DANCE_BREAK", searchQuery: "person dancing outdoor", visualDescription: "Person beginning to dance", targetSeconds: 2, priority: 5 },
  { shotNumber: 68, section: "DANCE_BREAK", searchQuery: "happy child dancing", visualDescription: "Child dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 69, section: "DANCE_BREAK", searchQuery: "friends dancing", visualDescription: "Friends dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 70, section: "DANCE_BREAK", searchQuery: "street dance people", visualDescription: "Street dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 71, section: "DANCE_BREAK", searchQuery: "festival dancing crowd", visualDescription: "Festival dancing", targetSeconds: 2, priority: 5 },
  { shotNumber: 72, section: "DANCE_BREAK", searchQuery: "people jumping together", visualDescription: "People jumping together", targetSeconds: 2, priority: 5 },
  { shotNumber: 73, section: "DANCE_BREAK", searchQuery: "crowd dancing celebration", visualDescription: "Crowd celebrating", targetSeconds: 2, priority: 5 },
  { shotNumber: 74, section: "DANCE_BREAK", searchQuery: "people dancing wide shot", visualDescription: "Wide dance scene", targetSeconds: 3, priority: 5 },
  { shotNumber: 75, section: "BRIDGE", searchQuery: "child looking around outdoors", visualDescription: "Child looking around", targetSeconds: 3, priority: 5 },
  { shotNumber: 76, section: "BRIDGE", searchQuery: "people park wide shot", visualDescription: "People together in park", targetSeconds: 3, priority: 4 },
  { shotNumber: 77, section: "BRIDGE", searchQuery: "children together outdoors", visualDescription: "Children together", targetSeconds: 3, priority: 5 },
  { shotNumber: 78, section: "BRIDGE", searchQuery: "family together outdoors", visualDescription: "Family together", targetSeconds: 3, priority: 4 },
  { shotNumber: 79, section: "BRIDGE", searchQuery: "people helping each other", visualDescription: "People helping each other", targetSeconds: 3, priority: 5 },
  { shotNumber: 80, section: "BRIDGE", searchQuery: "friends laughing outdoors", visualDescription: "Friends laughing", targetSeconds: 3, priority: 5 },
  { shotNumber: 81, section: "BRIDGE", searchQuery: "community people together", visualDescription: "Community together", targetSeconds: 3, priority: 5 },
  { shotNumber: 82, section: "BRIDGE", searchQuery: "people joining group", visualDescription: "Person joining a group", targetSeconds: 3, priority: 5 },
  { shotNumber: 83, section: "ACOUSTIC", searchQuery: "child natural smile", visualDescription: "Natural child smile", targetSeconds: 3, priority: 5 },
  { shotNumber: 84, section: "ACOUSTIC", searchQuery: "parent child laughing", visualDescription: "Parent and child laughing", targetSeconds: 3, priority: 5 },
  { shotNumber: 85, section: "ACOUSTIC", searchQuery: "friends natural laughter", visualDescription: "Friends laughing naturally", targetSeconds: 3, priority: 5 },
  { shotNumber: 86, section: "ACOUSTIC", searchQuery: "elderly person smiling outdoors", visualDescription: "Elderly person smiling", targetSeconds: 3, priority: 5 },
  { shotNumber: 87, section: "ACOUSTIC", searchQuery: "two people laughing natural", visualDescription: "Two people laughing", targetSeconds: 3, priority: 5 },
  { shotNumber: 88, section: "ACOUSTIC", searchQuery: "family happy candid", visualDescription: "Candid family moment", targetSeconds: 3, priority: 4 },
  { shotNumber: 89, section: "BUILD", searchQuery: "person walking sunlight", visualDescription: "Person walking in sunlight", targetSeconds: 2, priority: 4 },
  { shotNumber: 90, section: "BUILD", searchQuery: "two friends walking", visualDescription: "Two friends walking", targetSeconds: 2, priority: 4 },
  { shotNumber: 91, section: "BUILD", searchQuery: "friends walking together", visualDescription: "Small group walking", targetSeconds: 2, priority: 4 },
  { shotNumber: 92, section: "BUILD", searchQuery: "group people walking outdoors", visualDescription: "Larger group walking", targetSeconds: 2, priority: 5 },
  { shotNumber: 93, section: "BUILD", searchQuery: "people dancing beginning", visualDescription: "Group beginning to dance", targetSeconds: 3, priority: 5 },
  { shotNumber: 94, section: "FINAL_CHORUS", searchQuery: "children running sunlight", visualDescription: "Children running in sunlight", targetSeconds: 2, priority: 5 },
  { shotNumber: 95, section: "FINAL_CHORUS", searchQuery: "children laughing outdoors", visualDescription: "Children laughing", targetSeconds: 2, priority: 5 },
  { shotNumber: 96, section: "FINAL_CHORUS", searchQuery: "children dancing sunlight", visualDescription: "Children dancing in sunlight", targetSeconds: 2, priority: 5 },
  { shotNumber: 97, section: "FINAL_CHORUS", searchQuery: "family celebrating outdoors", visualDescription: "Family celebrating", targetSeconds: 2, priority: 5 },
  { shotNumber: 98, section: "FINAL_CHORUS", searchQuery: "diverse friends celebrating", visualDescription: "Diverse friends celebrating", targetSeconds: 2, priority: 5 },
  { shotNumber: 99, section: "FINAL_CHORUS", searchQuery: "community celebration outdoors", visualDescription: "Community celebration", targetSeconds: 2, priority: 5 },
  { shotNumber: 100, section: "FINAL_CHORUS", searchQuery: "people dancing sunshine", visualDescription: "People dancing in sunshine", targetSeconds: 2, priority: 5 },
] as const;

// Sanity guard: fail fast at import time if the dataset is malformed.
if (SHOT_DATASET.length !== 100) {
  throw new Error(`SHOT_DATASET must contain exactly 100 rows, got ${SHOT_DATASET.length}`);
}
for (let i = 0; i < SHOT_DATASET.length; i++) {
  const row = SHOT_DATASET[i]!;
  if (row.shotNumber !== i + 1) {
    throw new Error(`SHOT_DATASET row ${i} has shotNumber ${row.shotNumber}, expected ${i + 1}`);
  }
}
