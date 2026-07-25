import { PhoneIcon, MailIcon, MapPinIcon } from './ui/icons';
import { socialIcon } from './ui/iconMap';
import { Editable } from './Editable';

// The contact fields edited as one logical block (3.txt §2): phone, email and the
// address columns. Social links live in branding and are edited on the form, so
// they are not part of this region.
const CONTACT_FIELDS = [
  'phone',
  'email',
  'address_line',
  'city',
  'state',
  'postal_code',
];

interface ContactFooterProps {
  hotelName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  socials: Record<string, string>;
  year: number;
}

// Contact + footer. This is the anchor the Enquire buttons and Book Now point
// at. Phone/email become tel:/mailto: links; social links render only for the
// platforms present in the data. Phone, email and address come from the
// properties columns (003); social links come from branding — nothing here is a
// hardcoded tenant value (rule 17).
export function ContactFooter({
  hotelName,
  phone,
  email,
  address,
  socials,
  year,
}: ContactFooterProps) {
  const socialEntries = Object.entries(socials);
  const linkClass =
    'group flex items-center gap-3 text-cream/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal rounded';

  return (
    <footer
      id="contact"
      aria-labelledby="contact-heading"
      className="scroll-mt-24 bg-charcoal px-5 py-20 text-cream sm:px-8 lg:py-24"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 md:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-cream/60">
              Get in touch
            </p>
            <h2
              id="contact-heading"
              className="text-3xl font-semibold sm:text-4xl"
            >
              Contact us
            </h2>
            <p className="mt-4 max-w-md text-cream/70">
              Prefer to book by phone? Give us a call and our team will be glad
              to help arrange your stay.
            </p>
          </div>

          <div className="space-y-4">
            {/* Phone, email and address are one editable block (the Editable is a
                pass-through on the guest site; its className keeps the spacing in
                edit mode, where it becomes a real wrapper element). */}
            <Editable
              fields={CONTACT_FIELDS}
              label="Contact details"
              className="space-y-4"
            >
              {phone ? (
                <a href={`tel:${phone.replace(/\s+/g, '')}`} className={linkClass}>
                  <PhoneIcon className="h-5 w-5 shrink-0 text-accent" />
                  <span>{phone}</span>
                </a>
              ) : null}

              {email ? (
                <a href={`mailto:${email}`} className={linkClass}>
                  <MailIcon className="h-5 w-5 shrink-0 text-accent" />
                  <span className="break-all">{email}</span>
                </a>
              ) : null}

              {address ? (
                <div className="flex items-start gap-3 text-cream/90">
                  <MapPinIcon className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                  <span>{address}</span>
                </div>
              ) : null}
            </Editable>

            {socialEntries.length > 0 ? (
              <div className="flex flex-wrap gap-3 pt-2">
                {socialEntries.map(([platform, url]) => {
                  const Icon = socialIcon(platform);
                  return (
                    <a
                      key={platform}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={platform}
                      className="rounded-full bg-cream/10 p-2 text-cream hover:bg-cream/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-charcoal"
                    >
                      {Icon ? (
                        <Icon className="h-5 w-5" />
                      ) : (
                        <span className="text-sm capitalize">{platform}</span>
                      )}
                    </a>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-14 border-t border-cream/15 pt-6 text-sm text-cream/60">
          <p>
            © {year} {hotelName}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
