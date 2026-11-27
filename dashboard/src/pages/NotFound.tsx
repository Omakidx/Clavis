import { Link } from 'wouter';
import { usePage } from '../ui/page';

export function NotFound() {
  const heading = usePage('Page not found');
  return (
    <section>
      <h1 ref={heading} tabIndex={-1}>
        Page not found
      </h1>
      <p>This page does not exist.</p>
      <p>
        <Link href="/" className="btn">
          Go to Clavis
        </Link>
      </p>
    </section>
  );
}
