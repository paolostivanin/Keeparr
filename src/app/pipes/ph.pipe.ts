import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
    name: 'ph',
    standalone: false
})
export class ph implements PipeTransform {

  transform(value: string, dark = false) {
    let x = `url(${value})`
    return x.replace('.svg', dark ? '_dark_ph.svg' : '_ph.svg')

  }

}
