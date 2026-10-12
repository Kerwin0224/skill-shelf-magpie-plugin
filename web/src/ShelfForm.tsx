import type { ComponentProps } from 'react';

export function Input({ className = '', type, ...props }: ComponentProps<'input'>) {
  return <input {...props} className={`shelf-input ${className}`} data-slot="input" type={type} />;
}

export function Textarea({ className = '', ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={`shelf-textarea ${className}`} data-slot="textarea" />;
}
