import { Pipe, PipeTransform } from '@angular/core';
import { noteSurfaceVars } from '../utils/note-color';

/**
 * CSS variables (`--note-bg`, `--note-bg-dark`, ...) of a stored note color/image for a
 * `.note-surface` element. The theme picks the variant in CSS, so templates never depend on it.
 */
@Pipe({
  name: 'noteSurface',
  standalone: false
})
export class NoteSurfacePipe implements PipeTransform {
  transform(bgColor: string | null | undefined, bgImage: string | null | undefined = ''): Record<string, string> {
    return noteSurfaceVars(bgColor || '', bgImage || '');
  }
}
