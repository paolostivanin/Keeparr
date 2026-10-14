import { NoteI } from '../interfaces/notes';
import {
  clearNoteCardPageFilter, markNoteCardsEntering, noteCardKey, setNoteCardPageFilter, takeNoteCardEntering, withLeavingNoteCards
} from './note-card-motion';

const note = (id: number, extra: Partial<NoteI> = {}) => ({ id, syncId: `note-${id}`, ...extra }) as NoteI;

describe('note card motion', () => {
  const cards: HTMLElement[] = [];
  const stayOnPage = (n: NoteI) => !n.archived && !n.trashed;
  const addCard = (id: number) => {
    const card = document.createElement('div');
    card.className = 'note-container';
    card.dataset['noteId'] = String(id);
    document.body.append(card);
    cards.push(card);
    return card;
  };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  beforeEach(() => setNoteCardPageFilter(stayOnPage));
  afterEach(() => {
    clearNoteCardPageFilter(stayOnPage);
    cards.splice(0).forEach(card => card.remove());
  });

  describe('withLeavingNoteCards', () => {
    it('runs the change straight away when no grid registered a page filter', async () => {
      clearNoteCardPageFilter(stayOnPage);
      const card = addCard(1);
      const change = jasmine.createSpy('change').and.returnValue('done');

      expect(await withLeavingNoteCards([note(1)], { archived: true }, change)).toBe('done');
      expect(card.classList.contains('is-leaving')).toBeFalse();
    });

    it('fades a card the change takes off the page, and runs the change only after the fade', async () => {
      const card = addCard(1);
      const change = jasmine.createSpy('change').and.returnValue(7);

      const pending = withLeavingNoteCards([note(1)], { archived: true }, change);
      expect(card.classList.contains('is-leaving')).toBeTrue();
      expect(change).not.toHaveBeenCalled();

      expect(await pending).toBe(7);
      expect(change).toHaveBeenCalledTimes(1);
    });

    it('leaves a card alone when the page still lists the note afterwards', async () => {
      const card = addCard(1);
      const change = jasmine.createSpy('change');

      await withLeavingNoteCards([note(1)], { pinned: true }, change);

      expect(card.classList.contains('is-leaving')).toBeFalse();
      expect(change).toHaveBeenCalledTimes(1);
    });

    it('always fades the cards of notes that are removed outright', async () => {
      const card = addCard(1);
      const pending = withLeavingNoteCards([note(1)], null, () => undefined);
      expect(card.classList.contains('is-leaving')).toBeTrue();
      await pending;
    });

    it('un-hides the card again when the change did not remove it, and when the change fails', async () => {
      const card = addCard(1);
      await expectAsync(withLeavingNoteCards([note(1)], { trashed: true }, () => Promise.reject(new Error('offline')))).toBeRejectedWithError('offline');

      await wait(500);
      expect(card.classList.contains('is-leaving')).toBeFalse();
    });

    it('does not wait when the user prefers reduced motion', async () => {
      spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
      const card = addCard(1);

      await withLeavingNoteCards([note(1)], { archived: true }, () => undefined);

      expect(card.classList.contains('is-leaving')).toBeFalse();
    });
  });

  describe('entering cards', () => {
    it('keys a card by its sync id, falling back to the id', () => {
      expect(noteCardKey(note(3))).toBe('note-3');
      expect(noteCardKey({ id: 3 })).toBe('3');
    });

    it('reports a marked card once', () => {
      markNoteCardsEntering([note(4)]);

      expect(takeNoteCardEntering('note-4')).toBeTrue();
      expect(takeNoteCardEntering('note-4')).toBeFalse();
    });

    it('ignores cards that were never marked and a missing key', () => {
      expect(takeNoteCardEntering('note-5')).toBeFalse();
      expect(takeNoteCardEntering(undefined)).toBeFalse();
    });

    it('lets a mark expire, so a card shown much later is not animated', () => {
      const now = Date.now();
      const clock = spyOn(Date, 'now').and.returnValue(now);
      markNoteCardsEntering([note(6)]);
      clock.and.returnValue(now + 5000);

      expect(takeNoteCardEntering('note-6')).toBeFalse();
    });

    it('marks nothing under reduced motion', () => {
      spyOn(window, 'matchMedia').and.returnValue({ matches: true } as MediaQueryList);
      markNoteCardsEntering([note(7)]);

      expect(takeNoteCardEntering('note-7')).toBeFalse();
    });
  });
});
