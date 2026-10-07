import { CARD_LAYOUT_PREFERENCES, changedPreferences, UserPreferences } from './user-preferences.service';

const base: UserPreferences = {
  useTwentyFourHourTime: false, moveCompletedChecklistItemsToBottom: true, richLinkPreviews: true,
  notePreviewTextSize: 'default', showPastReminders: false
};

describe('preference changes', () => {
  it('reports nothing for an identical save and only the keys that differ otherwise', () => {
    expect(changedPreferences(base, { ...base })).toEqual([]);
    expect(changedPreferences(base, { ...base, richLinkPreviews: false, useTwentyFourHourTime: true })).toEqual(['useTwentyFourHourTime', 'richLinkPreviews']);
  });

  it('treats the clock style as non-layout and the card-shaping preferences as layout', () => {
    expect(CARD_LAYOUT_PREFERENCES).not.toContain('useTwentyFourHourTime');
    for (const key of ['richLinkPreviews', 'notePreviewTextSize', 'moveCompletedChecklistItemsToBottom', 'showPastReminders'] as const) {
      expect(CARD_LAYOUT_PREFERENCES).toContain(key);
    }
  });
});
