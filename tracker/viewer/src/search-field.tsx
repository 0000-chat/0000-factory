import { Search, X } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from './components/ui/input-group';

export interface SearchFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function SearchField({ label, value, onChange, placeholder }: SearchFieldProps) {
  return <InputGroup className="tracker-search-field">
    <InputGroupAddon align="inline-start" aria-hidden="true" className="tracker-search-field-icon">
      <Search />
    </InputGroupAddon>
    <InputGroupInput
      type="search"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={event => onChange(event.currentTarget.value)}
    />
    {value.length > 0 ? <InputGroupAddon align="inline-end" className="tracker-search-field-clear-addon">
      <InputGroupButton aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onChange('')}>
        <X aria-hidden="true" />
      </InputGroupButton>
    </InputGroupAddon> : null}
  </InputGroup>;
}
