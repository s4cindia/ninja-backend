/**
 * Unit group mappings for consistency checking.
 * Each group contains forms that should be used consistently within a document.
 */

export interface UnitGroup {
  name: string;
  forms: string[];
  abbreviated: string;
  full: string;
}

export const defaultUnitGroups: UnitGroup[] = [
  { name: 'milligrams', forms: ['mg', 'milligram', 'milligrams'], abbreviated: 'mg', full: 'milligrams' },
  { name: 'grams', forms: ['g', 'gram', 'grams'], abbreviated: 'g', full: 'grams' },
  { name: 'kilograms', forms: ['kg', 'kilogram', 'kilograms'], abbreviated: 'kg', full: 'kilograms' },
  { name: 'milliliters', forms: ['ml', 'mL', 'milliliter', 'milliliters', 'millilitre', 'millilitres'], abbreviated: 'mL', full: 'milliliters' },
  { name: 'liters', forms: ['l', 'L', 'liter', 'liters', 'litre', 'litres'], abbreviated: 'L', full: 'liters' },
  { name: 'centimeters', forms: ['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], abbreviated: 'cm', full: 'centimeters' },
  { name: 'millimeters', forms: ['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'], abbreviated: 'mm', full: 'millimeters' },
  { name: 'meters', forms: ['m', 'meter', 'meters', 'metre', 'metres'], abbreviated: 'm', full: 'meters' },
  { name: 'kilometers', forms: ['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres'], abbreviated: 'km', full: 'kilometers' },
  { name: 'seconds', forms: ['s', 'sec', 'second', 'seconds'], abbreviated: 's', full: 'seconds' },
  { name: 'minutes', forms: ['min', 'minute', 'minutes'], abbreviated: 'min', full: 'minutes' },
  { name: 'hours', forms: ['h', 'hr', 'hour', 'hours'], abbreviated: 'h', full: 'hours' },
  { name: 'hertz', forms: ['Hz', 'hertz'], abbreviated: 'Hz', full: 'hertz' },
  { name: 'kilohertz', forms: ['kHz', 'kilohertz'], abbreviated: 'kHz', full: 'kilohertz' },
  { name: 'megahertz', forms: ['MHz', 'megahertz'], abbreviated: 'MHz', full: 'megahertz' },
  { name: 'celsius', forms: ['°C', 'degrees Celsius', 'degree Celsius'], abbreviated: '°C', full: 'degrees Celsius' },
  { name: 'fahrenheit', forms: ['°F', 'degrees Fahrenheit', 'degree Fahrenheit'], abbreviated: '°F', full: 'degrees Fahrenheit' },
  { name: 'kelvin', forms: ['K', 'kelvin'], abbreviated: 'K', full: 'kelvin' },
  { name: 'moles', forms: ['mol', 'mole', 'moles'], abbreviated: 'mol', full: 'moles' },
  { name: 'millimoles', forms: ['mmol', 'millimole', 'millimoles'], abbreviated: 'mmol', full: 'millimoles' },
  { name: 'joules', forms: ['J', 'joule', 'joules'], abbreviated: 'J', full: 'joules' },
  { name: 'kilojoules', forms: ['kJ', 'kilojoule', 'kilojoules'], abbreviated: 'kJ', full: 'kilojoules' },
  { name: 'watts', forms: ['W', 'watt', 'watts'], abbreviated: 'W', full: 'watts' },
  { name: 'kilowatts', forms: ['kW', 'kilowatt', 'kilowatts'], abbreviated: 'kW', full: 'kilowatts' },
  { name: 'volts', forms: ['V', 'volt', 'volts'], abbreviated: 'V', full: 'volts' },
  { name: 'amperes', forms: ['A', 'ampere', 'amperes', 'amp', 'amps'], abbreviated: 'A', full: 'amperes' },
  { name: 'micrometers', forms: ['µm', 'micrometer', 'micrometers', 'micrometre', 'micrometres', 'micron', 'microns'], abbreviated: 'µm', full: 'micrometers' },
  { name: 'nanometers', forms: ['nm', 'nanometer', 'nanometers', 'nanometre', 'nanometres'], abbreviated: 'nm', full: 'nanometers' },
  { name: 'pascals', forms: ['Pa', 'pascal', 'pascals'], abbreviated: 'Pa', full: 'pascals' },
  { name: 'kilopascals', forms: ['kPa', 'kilopascal', 'kilopascals'], abbreviated: 'kPa', full: 'kilopascals' },
];

/**
 * Find which unit group a given unit form belongs to.
 */
export function findUnitGroup(form: string): UnitGroup | undefined {
  return defaultUnitGroups.find(g =>
    g.forms.some(f => f.toLowerCase() === form.toLowerCase())
  );
}
